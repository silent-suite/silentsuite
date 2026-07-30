package io.silentsuite.sync.ui

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.GravityCompat
import androidx.drawerlayout.widget.DrawerLayout
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import androidx.lifecycle.Lifecycle
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.R
import io.silentsuite.sync.resource.LocalAddressBook
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.ui.setup.PostLoginSetupState
import io.silentsuite.sync.utils.AndroidCompat
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AccountDrawerSignOutRuntimeTest {
    private fun waitUntil(description: String, timeoutMillis: Long = 10_000, predicate: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        while (SystemClock.uptimeMillis() < deadline) {
            if (predicate()) return
            SystemClock.sleep(25)
        }
        assertTrue("Timed out waiting for $description", predicate())
    }

    @Test fun oneAccountSwitcherExposesAddRowAndCurrentSemanticsAfterRecreation() {
        val fixture = Fixture("switcher")
        fixture.use { account ->
            ActivityScenario.launch<AccountActivity>(AccountActivity.newIntent(fixture.context, account)).use { scenario ->
                scenario.recreate()
                scenario.onActivity { activity ->
                    activity.findViewById<DrawerLayout>(R.id.drawer_layout)
                        .openDrawer(GravityCompat.START, false)
                    val header = activity.findViewById<View>(R.id.nav_account_header)
                    header.performClick()
                    val add = activity.findViewById<View>(R.id.nav_add_account_row)
                    val row = activity.findViewById<View>(AccountActivity.accountRowViewId(
                        ExactAccountIdentity(account.type, account.name, fixture.creationId)))
                    assertTrue(add.isShown)
                    assertTrue(add.isClickable)
                    assertTrue(row.isShown)
                    assertTrue(row.isSelected)
                    assertEquals(activity.getString(R.string.account_switcher_current),
                        ViewCompat.getStateDescription(row)?.toString())
                    assertEquals(activity.getString(R.string.account_switcher_expanded),
                        ViewCompat.getStateDescription(header)?.toString())
                }
            }
        }
    }

    @Test fun systemBackClosesDrawerWithoutFinishing() {
        val fixture = Fixture("system-back-drawer")
        fixture.use { account ->
            ActivityScenario.launch<AccountActivity>(AccountActivity.newIntent(fixture.context, account)).use { scenario ->
                scenario.onActivity { activity ->
                    activity.findViewById<DrawerLayout>(R.id.drawer_layout)
                        .openDrawer(GravityCompat.START, false)
                    assertTrue(activity.findViewById<DrawerLayout>(R.id.drawer_layout)
                        .isDrawerOpen(GravityCompat.START))
                }
                UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).pressBack()
                waitUntil("drawer to close after system Back") {
                    var closed = false
                    scenario.onActivity { activity ->
                        closed = !activity.isFinishing && !activity.findViewById<DrawerLayout>(R.id.drawer_layout)
                            .isDrawerOpen(GravityCompat.START)
                    }
                    closed
                }
                assertEquals(Lifecycle.State.RESUMED, scenario.state)
            }
        }
    }

    @Test fun delayedRemovalFailureSurvivesRecreationAndDuplicateTapStartsOnce() {
        val fixture = Fixture("failure")
        val fake = DelayedFailureSeams(fixture.account)
        CurrentAccountSignOutViewModel.seamsFactory = { _, exact, generation ->
            assertEquals(fixture.account, exact)
            assertEquals(fixture.creationId, generation)
            fake
        }
        try {
            ActivityScenario.launch<AccountActivity>(AccountActivity.newIntent(fixture.context, fixture.account)).use { scenario ->
                scenario.onActivity { activity ->
                    val model = androidx.lifecycle.ViewModelProvider(activity)[CurrentAccountSignOutViewModel::class.java]
                    model.begin()
                    model.begin()
                    assertEquals(1, fake.removeCalls)
                }
                scenario.recreate()
                fake.callback!!(false)
                InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                scenario.onActivity { activity ->
                    assertTrue(activity.findViewById<com.google.android.material.navigation.NavigationView>(R.id.nav_view)
                        .menu.findItem(R.id.nav_logout).isEnabled)
                    assertEquals(0, fake.destructiveCleanupCalls)
                }
            }
        } finally {
            CurrentAccountSignOutViewModel.seamsFactory = null
            fixture.close()
        }
    }

    @Test fun actualTwoAccountSignOutRemovesExactMainAndChildAndActivatesSibling() {
        val target = Fixture("actual-target")
        val sibling = Fixture("actual-sibling")
        val child = Account("child-${System.nanoTime()}@example.invalid", App.addressBookAccountType)
        check(target.manager.addAccountExplicitly(
            child,
            null,
            LocalAddressBook.initialUserData(target.account, SyncStatusStore(target.context).identity(target.account), "https://example.invalid/address-book"),
        ))
        try {
            assertTrue(ActiveAccountManager.setActiveAccount(target.context, target.account))
            val statusStore = SyncStatusStore(target.context)
            assertTrue(statusStore.recordSuccess(target.account, SyncStatusStore.Service.CALENDAR, 123L))
            assertEquals(123L,
                statusStore.status(target.account, SyncStatusStore.Service.CALENDAR).lastSuccessAt)
            val expectedReplacement = target.manager.getAccountsByType(App.accountType).mapNotNull { candidate ->
                target.manager.getUserData(candidate, AccountSettings.KEY_CREATION_ID)?.takeIf(String::isNotBlank)?.let {
                    ExactAccountIdentity(candidate.type, candidate.name, it)
                }
            }.let(AccountSwitcherPolicy::ordered).first { it != ExactAccountIdentity(
                target.account.type, target.account.name, target.creationId) }
            val completed = CountDownLatch(1)
            var finalState: CurrentAccountSignOutState? = null
            val coordinator = CurrentAccountSignOutCoordinator(
                AndroidCurrentAccountSignOut(target.context, target.account, target.creationId)
            ) { state ->
                if (state is CurrentAccountSignOutState.Complete) {
                    finalState = state
                    completed.countDown()
                }
            }
            coordinator.begin()
            assertTrue("sign-out did not complete", completed.await(15, TimeUnit.SECONDS))
            assertEquals(expectedReplacement, (finalState as CurrentAccountSignOutState.Complete).replacement)
            assertFalse(target.account in target.manager.getAccountsByType(target.account.type))
            assertFalse(child in target.manager.getAccountsByType(child.type))
            // Recreate the same exact generation temporarily. Any uncleared status would now be
            // visible again because SyncStatusStore keys include this creation ID.
            assertTrue(target.manager.addAccountExplicitly(target.account, null, null))
            assertTrue(AccountSettings.writeVerified(target.manager, target.account,
                AccountSettings.KEY_CREATION_ID, target.creationId))
            assertEquals(SyncStatusStore.Status(),
                statusStore.status(target.account, SyncStatusStore.Service.CALENDAR))
            assertEquals(
                Account(expectedReplacement.name, expectedReplacement.type),
                ActiveAccountManager.getActiveAccount(target.context),
            )
        } finally {
            removeAccountAndWait(target.manager, child)
            sibling.close()
            target.close()
        }
    }

    @Test fun adapterRefusesToRemoveSameNameReplacementGeneration() {
        val fixture = Fixture("replacement")
        var adapter: AndroidCurrentAccountSignOut? = null
        try {
            val oldIdentity = ExactAccountIdentity(fixture.account.type, fixture.account.name, fixture.creationId)
            val retainedAdapter = AndroidCurrentAccountSignOut(fixture.context, fixture.account, fixture.creationId)
            adapter = retainedAdapter
            removeAccountAndWait(fixture.manager, fixture.account)
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            val replacementGeneration = "replacement-successor-generation"
            assertNotEquals(fixture.creationId, replacementGeneration)
            val replacementData = Bundle().apply {
                putString(AccountSettings.KEY_CREATION_ID, replacementGeneration)
            }
            assertTrue(fixture.manager.addAccountExplicitly(fixture.account, null, replacementData))
            val replacementRow = fixture.manager.getAccountsByType(fixture.account.type)
                .single { it.name == fixture.account.name }
            assertEquals(replacementGeneration,
                fixture.manager.getUserData(replacementRow, AccountSettings.KEY_CREATION_ID))

            waitUntil("replacement generation visibility") {
                retainedAdapter.mainGenerationAbsent(oldIdentity)
            }
            val callbackReceived = CountDownLatch(1)
            var callback: Boolean? = null
            retainedAdapter.removeMain(oldIdentity) {
                callback = it
                callbackReceived.countDown()
            }
            assertTrue("replacement refusal callback timed out", callbackReceived.await(10, TimeUnit.SECONDS))
            assertEquals(false, callback)
            waitUntil("replacement generation visibility") {
                retainedAdapter.mainGenerationAbsent(oldIdentity)
            }
            assertTrue(fixture.account in fixture.manager.getAccountsByType(fixture.account.type))
        } finally {
            adapter?.close()
            fixture.close()
        }
    }

    @Test fun delayedSuccessfulRemovalAfterRecreationRoutesRetainedSibling() {
        val target = Fixture("retained-target")
        val sibling = Fixture("retained-sibling")
        val siblingIdentity = ExactAccountIdentity(sibling.account.type, sibling.account.name, sibling.creationId)
        val fake = DelayedSuccessSeams(target.context, target.account, target.creationId, sibling.account, siblingIdentity)
        CurrentAccountSignOutViewModel.seamsFactory = { _, _, _ -> fake }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        try {
            ActivityScenario.launch<AccountActivity>(AccountActivity.newIntent(target.context, target.account)).use { scenario ->
                scenario.onActivity { activity ->
                    androidx.lifecycle.ViewModelProvider(activity)[CurrentAccountSignOutViewModel::class.java].begin()
                }
                // The platform row disappears while the retained coordinator still awaits its
                // callback. The recreated Activity must attach to that coordinator before trying
                // to validate its now-stale explicit route.
                removeAccountAndWait(target.manager, target.account)
                scenario.recreate()
                val monitor = instrumentation.addMonitor(AccountActivity::class.java.name, null, false)
                var launched: android.app.Activity? = null
                try {
                    // The retained ViewModel already owns its coordinator. Do not let this
                    // target-specific factory initialize the replacement sibling Activity.
                    CurrentAccountSignOutViewModel.seamsFactory = null
                    fake.absent = true
                    fake.callback!!(true)
                    launched = instrumentation.waitForMonitorWithTimeout(monitor, 10_000)
                    val replacementActivity = requireNotNull(launched) { "replacement AccountActivity was not launched" }
                    instrumentation.waitForIdleSync()
                    assertEquals(sibling.account,
                        replacementActivity.intent.getParcelableExtra<Account>(AccountActivity.EXTRA_ACCOUNT))
                    assertEquals(sibling.creationId,
                        replacementActivity.intent.getStringExtra(AccountActivity.EXTRA_CREATION_ID))
                    assertFalse("replacement AccountActivity rejected its exact route", replacementActivity.isFinishing)
                    assertEquals(1, fake.removeCalls)
                    assertEquals(sibling.account, ActiveAccountManager.getActiveAccount(target.context))
                } finally {
                    launched?.finish()
                    instrumentation.removeMonitor(monitor)
                }
            }
        } finally {
            CurrentAccountSignOutViewModel.seamsFactory = null
            sibling.close()
            target.close()
        }
    }

    private class DelayedFailureSeams(account: Account) : CurrentAccountSignOutCoordinator.Seams {
        private val identity = ExactAccountIdentity(account.type, account.name, "failure-generation")
        var removeCalls = 0
        var destructiveCleanupCalls = 0
        var callback: ((Boolean) -> Unit)? = null
        override fun snapshot() = CurrentAccountSignOutSnapshot(identity, emptyList(), listOf(identity))
        override fun cancelSync(identity: Pair<String, String>) = Unit
        override fun removeMain(main: ExactAccountIdentity, callback: (Boolean) -> Unit) {
            removeCalls++
            this.callback = callback
        }
        override fun mainGenerationAbsent(main: ExactAccountIdentity) = false
        override fun clearCache(main: ExactAccountIdentity) = true.also { destructiveCleanupCalls++ }
        override fun clearStatus(main: ExactAccountIdentity) = true.also { destructiveCleanupCalls++ }
        override fun reconcileActive(main: ExactAccountIdentity, replacement: ExactAccountIdentity?) =
            ActiveAccountReconciliation(true, replacement).also { destructiveCleanupCalls++ }
        override fun removeAndVerifyChildren(snapshot: CurrentAccountSignOutSnapshot, callback: (Boolean) -> Unit) {
            destructiveCleanupCalls++
            callback(true)
        }
    }

    private class DelayedSuccessSeams(
        private val context: Context,
        target: Account,
        generation: String,
        private val siblingAccount: Account,
        private val sibling: ExactAccountIdentity,
    ) : CurrentAccountSignOutCoordinator.Seams {
        private val targetIdentity = ExactAccountIdentity(target.type, target.name, generation)
        var absent = false
        var removeCalls = 0
        var callback: ((Boolean) -> Unit)? = null
        override fun snapshot() = CurrentAccountSignOutSnapshot(targetIdentity, emptyList(), listOf(targetIdentity, sibling))
        override fun cancelSync(identity: Pair<String, String>) = Unit
        override fun removeMain(main: ExactAccountIdentity, callback: (Boolean) -> Unit) {
            removeCalls++
            this.callback = callback
        }
        override fun mainGenerationAbsent(main: ExactAccountIdentity) = absent
        override fun clearCache(main: ExactAccountIdentity) = true
        override fun clearStatus(main: ExactAccountIdentity) = true
        override fun reconcileActive(main: ExactAccountIdentity, replacement: ExactAccountIdentity?) =
            ActiveAccountReconciliation(ActiveAccountManager.setActiveAccount(context, siblingAccount), sibling)
        override fun removeAndVerifyChildren(snapshot: CurrentAccountSignOutSnapshot, callback: (Boolean) -> Unit) = callback(true)
    }

    private fun removeAccountAndWait(manager: AccountManager, account: Account) {
        if (account !in manager.getAccountsByType(account.type)) return
        val removed = CountDownLatch(1)
        AndroidCompat.removeAccount(manager, account) { removed.countDown() }
        assertTrue("account removal callback timed out", removed.await(10, TimeUnit.SECONDS))
        assertFalse("account row remained after confirmed removal", account in manager.getAccountsByType(account.type))
    }

    private inner class Fixture(private val label: String) : AutoCloseable {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = Account("$label-${System.nanoTime()}@example.invalid", App.accountType)
        val creationId = "$label-generation"
        private val previousBootstrap = App.postLoginBootstrapSucceeded
        init {
            check(manager.addAccountExplicitly(account, null, null))
            AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
            check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, creationId))
            check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_LIMITED_INTEGRATIONS, "true"))
            check(AccountSettings.writeSetupState(manager, account, PostLoginSetupState.COMPLETE))
            App.postLoginBootstrapSucceeded = true
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                InstrumentationRegistry.getInstrumentation().uiAutomation
                    .executeShellCommand("pm grant ${context.packageName} ${Manifest.permission.POST_NOTIFICATIONS}").close()
            }
        }
        fun use(block: (Account) -> Unit) = try { block(account) } finally { close() }
        override fun close() {
            App.postLoginBootstrapSucceeded = previousBootstrap
            removeAccountAndWait(manager, account)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }
}
